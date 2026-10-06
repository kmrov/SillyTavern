import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import tiktoken from 'tiktoken';

import { SETTINGS_FILE } from './constants.js';
import { trySaveChat } from './endpoints/chats.js';
import { processCharacter } from './endpoints/characters.js';
import { readWorldInfoFile } from './endpoints/worldinfo.js';
import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';
import { excludeKeysByYaml, mergeObjectWithYaml } from './util.js';

const DEFAULT_CHAT_ID = 'external-api';
const chatLocks = new Map();
const tokenizer = tiktoken.get_encoding('cl100k_base');

function countTokens(text) {
    return tokenizer.encode(text).length;
}

export class CharacterChatError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function validFileStem(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 160
        && value !== '.' && value !== '..' && sanitize(value) === value
        && !/[\\/\x00]/.test(value) && !value.toLowerCase().endsWith('.jsonl');
}

function substituteNames(text, characterName, userName) {
    return String(text ?? '').replace(/{{char}}/gi, characterName).replace(/{{user}}/gi, userName);
}

function keyMatches(text, key, caseSensitive, wholeWords) {
    if (typeof key !== 'string' || !key.trim()) return false;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = wholeWords ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
    return new RegExp(expression, caseSensitive ? 'u' : 'iu').test(text);
}

/** Basic server-side World Info activation for constant and keyword entries. */
export function getActivatedLore({ directories, character, chatMetadata, settings, history, userName }) {
    const wiSettings = settings.world_info_settings ?? {};
    const worldInfo = wiSettings.world_info ?? {};
    const characterStem = path.parse(character.avatar).name;
    const extraBooks = worldInfo.charLore?.find(item => item.name === characterStem)?.extraBooks ?? [];
    const books = [...new Set([
        ...(worldInfo.globalSelect ?? []),
        character.data?.extensions?.world,
        ...extraBooks,
        chatMetadata?.world_info,
    ].filter(Boolean))];
    const depth = Math.max(1, Number(wiSettings.world_info_depth) || 2);
    const scanText = history.slice(-depth).map(item => wiSettings.world_info_include_names === false ? item.mes : `${item.name}: ${item.mes}`).join('\n');
    const entries = [];

    for (const book of books) {
        const data = readWorldInfoFile(directories, book, false);
        for (const entry of Object.values(data?.entries ?? {})) {
            if (entry.disable || !entry.content || ![0, 1, 4].includes(entry.position)) continue;
            const text = scanText;
            const caseSensitive = entry.caseSensitive ?? wiSettings.world_info_case_sensitive ?? false;
            const wholeWords = entry.matchWholeWords ?? wiSettings.world_info_match_whole_words ?? false;
            const matches = keys => Array.isArray(keys) && keys.some(key => keyMatches(text, key, caseSensitive, wholeWords));
            if (!entry.constant && !matches(entry.key)) continue;
            if (!entry.constant && entry.selective !== false && Array.isArray(entry.keysecondary) && entry.keysecondary.length) {
                const secondaryMatches = entry.keysecondary.map(key => keyMatches(text, key, caseSensitive, wholeWords));
                const logic = Number(entry.selectiveLogic ?? 0);
                if (logic === 0 && !secondaryMatches.some(Boolean)) continue;
                if (logic === 1 && secondaryMatches.every(Boolean)) continue;
                if (logic === 2 && secondaryMatches.some(Boolean)) continue;
                if (logic === 3 && !secondaryMatches.every(Boolean)) continue;
            }
            if (entry.useProbability && Math.random() * 100 > Number(entry.probability ?? 100)) continue;
            entries.push(entry);
        }
    }

    entries.sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0));
    const maxContext = Number(settings.oai_settings?.openai_max_context) || 4096;
    const budgetPercent = Number(wiSettings.world_info_budget ?? 25);
    const budgetTokens = Math.min(Math.round(maxContext * budgetPercent / 100), Number(wiSettings.world_info_budget_cap) || Infinity);
    const budgetChars = Math.max(0, budgetTokens * 4);
    const output = { before: [], after: [], depth: [] };
    let usedChars = 0;
    for (const entry of entries) {
        const content = substituteNames(entry.content, character.name, userName);
        if (!entry.ignoreBudget && usedChars + content.length > budgetChars) continue;
        usedChars += content.length;
        if (entry.position === 4) {
            output.depth.push({ content, depth: Number(entry.depth) || 1, role: ['system', 'user', 'assistant'][Number(entry.role) || 0] || 'system' });
        } else {
            output[entry.position === 1 ? 'after' : 'before'].push(content);
        }
    }
    return output;
}

function buildMessages({ character, chatData, message, settings, directories }) {
    const userName = settings.username || 'User';
    const prior = chatData.slice(1).filter(item => !item.is_system && typeof item.mes === 'string');
    const userMessage = { name: userName, is_user: true, is_system: false, mes: message };
    const history = [...prior, userMessage];
    const lore = getActivatedLore({ directories, character, chatMetadata: chatData[0]?.chat_metadata, settings, history, userName });
    const card = character.data ?? character;
    const metadata = chatData[0]?.chat_metadata ?? {};
    const prompts = settings.oai_settings?.prompts ?? [];
    const promptById = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    const sections = {
        main: [promptById.get('main')?.content || 'Write the next reply as {{char}} in a conversation with {{user}}.',
            settings.power_user?.prefer_character_prompt === false ? '' : metadata.system_prompt || card.system_prompt].filter(Boolean).join('\n\n'),
        worldInfoBefore: lore.before.join('\n'),
        charDescription: card.description && `Description: ${card.description}`,
        charPersonality: card.personality && `Personality: ${card.personality}`,
        scenario: (metadata.scenario || card.scenario) && `Scenario: ${metadata.scenario || card.scenario}`,
        dialogueExamples: (metadata.mes_example || card.mes_example) && `Example dialogue:\n${metadata.mes_example || card.mes_example}`,
        worldInfoAfter: lore.after.join('\n'),
        jailbreak: [settings.power_user?.prefer_character_jailbreak === false ? '' : card.post_history_instructions,
            promptById.get('jailbreak')?.content].filter(Boolean).join('\n\n'),
    };
    const configuredOrder = settings.oai_settings?.prompt_order?.find(item => item.character_id === 100000)?.order;
    const order = Array.isArray(configuredOrder) ? configuredOrder : [
        'main', 'worldInfoBefore', 'charDescription', 'charPersonality', 'scenario',
        'dialogueExamples', 'worldInfoAfter', 'chatHistory', 'jailbreak',
    ].map(identifier => ({ identifier, enabled: true }));
    const staticChars = order.filter(item => item.enabled).reduce((count, item) =>
        count + String(sections[item.identifier] ?? promptById.get(item.identifier)?.content ?? '').length, 0);
    const contextTokens = Number(settings.oai_settings?.openai_max_context) || 4096;
    const replyTokens = Number(settings.oai_settings?.openai_max_tokens) || 300;
    const maxPromptChars = Math.max(256, (contextTokens - replyTokens) * 4);
    const maxPromptTokens = Math.max(1, contextTokens - replyTokens - 32);
    let usedChars = staticChars + lore.depth.reduce((count, entry) => count + entry.content.length, 0);
    let usedTokens = order.filter(item => item.enabled).reduce((count, item) =>
        count + countTokens(String(sections[item.identifier] ?? promptById.get(item.identifier)?.content ?? '')), 0)
        + lore.depth.reduce((count, entry) => count + countTokens(entry.content) + 4, 0);
    const keptHistory = [];
    for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index];
        const itemTokens = countTokens(item.mes) + 4;
        if (keptHistory.length && (usedChars + item.mes.length > maxPromptChars || usedTokens + itemTokens > maxPromptTokens)) break;
        keptHistory.unshift(item);
        usedChars += item.mes.length;
        usedTokens += itemTokens;
    }
    const historyMessages = keptHistory.map(item => ({ role: item.is_user ? 'user' : 'assistant', content: item.mes }));
    for (const entry of lore.depth) {
        const index = Math.max(0, historyMessages.length - entry.depth);
        historyMessages.splice(index, 0, { role: entry.role, content: entry.content });
    }
    const messages = [];
    let historyInserted = false;
    for (const item of order) {
        if (!item.enabled) continue;
        if (item.identifier === 'chatHistory') {
            messages.push(...historyMessages);
            historyInserted = true;
            continue;
        }
        const content = substituteNames(sections[item.identifier] ?? promptById.get(item.identifier)?.content ?? '', character.name, userName);
        if (!content) continue;
        const role = promptById.get(item.identifier)?.role || 'system';
        if (role === 'system' && messages.at(-1)?.role === 'system') {
            messages.at(-1).content += `\n\n${content}`;
        } else {
            messages.push({ role, content });
        }
    }
    if (!historyInserted) messages.push(...historyMessages);
    if (messages.reduce((length, item) => length + item.content.length, 0) > maxPromptChars
        || messages.reduce((count, item) => count + countTokens(item.content) + 4, 0) > maxPromptTokens) {
        throw new CharacterChatError(413, 'The character prompt or message exceeds the selected model context.');
    }
    return messages;
}

/** Send through the selected OpenAI-compatible Chat Completion source. */
export async function generateWithStoredSettings({ messages, settings, directories }, fetchImpl = fetch) {
    const options = settings.oai_settings;
    const source = options.chat_completion_source;
    const providers = {
        openai: { url: options.reverse_proxy || 'https://api.openai.com/v1', model: options.openai_model, secret: SECRET_KEYS.OPENAI },
        openrouter: { url: 'https://openrouter.ai/api/v1', model: options.openrouter_model, secret: SECRET_KEYS.OPENROUTER },
        custom: { url: options.custom_url, model: options.custom_model, secret: SECRET_KEYS.CUSTOM },
    };
    const provider = providers[source];
    if (!provider) throw new CharacterChatError(422, `Chat Completion source "${source}" is not supported by the character chat API.`);
    if (!provider.model || !provider.url || provider.model === 'OR_Website') {
        throw new CharacterChatError(422, 'The selected Chat Completion model or URL is not configured.');
    }
    let url;
    try {
        url = new URL(`${provider.url.replace(/\/$/, '')}/chat/completions`);
    } catch {
        throw new CharacterChatError(422, 'The selected Chat Completion URL is invalid.');
    }
    const apiKey = source === 'openai' && options.reverse_proxy
        ? options.proxy_password
        : readSecret(directories, provider.secret);
    if (!apiKey && source !== 'custom') throw new CharacterChatError(422, `API key for ${source} is not configured.`);
    const requestHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || ''}` };
    const requestBody = {
        model: provider.model, messages, stream: false,
        temperature: Number(options.temp_openai ?? 1),
        max_tokens: Number(options.openai_max_tokens ?? 300),
        top_p: Number(options.top_p_openai ?? 1),
        frequency_penalty: Number(options.freq_pen_openai ?? 0),
        presence_penalty: Number(options.pres_pen_openai ?? 0),
    };
    if (Number(options.seed) >= 0) requestBody.seed = Number(options.seed);
    if (source === 'openai' || source === 'openrouter') {
        const model = source === 'openrouter' ? provider.model.replace(/^openai\//, '') : provider.model;
        if (/^(o1|o3|o4)/.test(model)) {
            requestBody.max_completion_tokens = requestBody.max_tokens;
            delete requestBody.max_tokens;
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.frequency_penalty;
            delete requestBody.presence_penalty;
            if (model.startsWith('o1')) requestBody.messages = messages.map(item => item.role === 'system' ? { ...item, role: 'user' } : item);
        } else if (/gpt-5/.test(model)) {
            requestBody.max_completion_tokens = requestBody.max_tokens;
            delete requestBody.max_tokens;
            if (!/gpt-5-chat-latest/.test(model)) {
                if (/gpt-5\.(1|2|3|4)/.test(model) && !options.reasoning_effort) {
                    delete requestBody.frequency_penalty;
                    delete requestBody.presence_penalty;
                } else {
                    delete requestBody.temperature;
                    delete requestBody.top_p;
                    delete requestBody.frequency_penalty;
                    delete requestBody.presence_penalty;
                }
            }
        } else if (/gpt-6-astra/.test(model)) {
            requestBody.max_completion_tokens = requestBody.max_tokens;
            delete requestBody.max_tokens;
            delete requestBody.temperature;
            delete requestBody.top_p;
        }
    }
    if (source === 'custom') {
        mergeObjectWithYaml(requestHeaders, options.custom_include_headers);
        mergeObjectWithYaml(requestBody, options.custom_include_body);
        excludeKeysByYaml(requestBody, options.custom_exclude_body);
    }
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(300_000),
        });
    } catch (error) {
        throw new CharacterChatError(502, `Chat Completion request failed: ${error.message}`);
    }
    if (!response.ok) throw new CharacterChatError(502, `Chat Completion source returned HTTP ${response.status}.`);
    const result = await response.json();
    const content = result?.choices?.[0]?.message?.content;
    const reply = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
    if (!reply.trim()) throw new CharacterChatError(502, 'Chat Completion source returned no assistant text.');
    return reply;
}

async function withChatLock(key, work) {
    const previous = chatLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    chatLocks.set(key, current);
    await previous;
    try {
        return await work();
    } finally {
        release();
        if (chatLocks.get(key) === current) chatLocks.delete(key);
    }
}

/** Generate and persist one turn using the user's stored character, lore and model settings. */
export async function sendCharacterMessage({ directories, handle, characterId, avatarUrl, chatId = DEFAULT_CHAT_ID, message, generate = generateWithStoredSettings }) {
    if (characterId !== undefined && !validFileStem(characterId)) {
        throw new CharacterChatError(400, 'character_id must be a character filename without .png.');
    }
    if (avatarUrl !== undefined && (typeof avatarUrl !== 'string' || !avatarUrl.endsWith('.png') || !validFileStem(avatarUrl))) {
        throw new CharacterChatError(400, 'avatar_url must be a character PNG filename.');
    }
    if (characterId === undefined && avatarUrl === undefined) {
        throw new CharacterChatError(400, 'character_id is required.');
    }
    if (characterId !== undefined && avatarUrl !== undefined && `${characterId}.png` !== avatarUrl) {
        throw new CharacterChatError(400, 'character_id and avatar_url refer to different characters.');
    }
    avatarUrl = avatarUrl ?? `${characterId}.png`;
    if (!validFileStem(chatId)) throw new CharacterChatError(400, 'chat_id must be a valid chat filename without .jsonl.');
    if (typeof message !== 'string' || !message.trim()) throw new CharacterChatError(400, 'message must be a non-empty string.');
    if (message.length > 100_000) throw new CharacterChatError(413, 'message is too long.');

    const characterPath = path.join(directories.characters, avatarUrl);
    if (!fs.existsSync(characterPath)) throw new CharacterChatError(404, 'Character not found.');
    const chatDir = path.join(directories.chats, path.parse(avatarUrl).name);
    const chatFile = path.join(chatDir, `${chatId}.jsonl`);

    return withChatLock(chatFile, async () => {
        const character = await processCharacter(avatarUrl, directories, { shallow: false });
        if (!character.name) throw new CharacterChatError(422, 'Character card could not be read.');
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
        } catch {
            throw new CharacterChatError(409, 'User settings could not be read.');
        }
        if (settings.main_api !== 'openai' || !settings.oai_settings) {
            throw new CharacterChatError(409, 'Select a Chat Completion source in SillyTavern before using this API.');
        }

        const userName = settings.username || 'User';
        const now = new Date().toISOString();
        let chatData = [
            { chat_metadata: {}, user_name: userName, character_name: character.name },
            ...(character.first_mes ? [{ name: character.name, is_user: false, is_system: false, send_date: now, mes: character.first_mes, extra: {} }] : []),
        ];
        let originalContent;
        if (fs.existsSync(chatFile)) {
            try {
                originalContent = fs.readFileSync(chatFile, 'utf8');
                chatData = originalContent.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
            } catch {
                throw new CharacterChatError(422, 'Chat file contains invalid JSONL and was left unchanged.');
            }
        }
        if (!chatData.length || !chatData[0]?.chat_metadata) throw new CharacterChatError(422, 'Chat file is invalid.');
        const messages = buildMessages({ character, chatData, message, settings, directories });
        const reply = await generate({ messages, settings, directories });
        if (typeof reply !== 'string' || !reply.trim()) throw new CharacterChatError(502, 'Model returned no assistant text.');
        const assertUnchanged = () => {
            const currentContent = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, 'utf8') : undefined;
            if (currentContent !== originalContent) {
                throw new CharacterChatError(409, 'Chat changed during generation. Retry the message.');
            }
        };
        assertUnchanged();
        chatData[0].chat_metadata.tainted = true;
        chatData.push(
            { name: userName, is_user: true, is_system: false, send_date: now, mes: message, extra: {} },
            { name: character.name, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: reply, extra: {} },
        );
        fs.mkdirSync(chatDir, { recursive: true });
        await trySaveChat(chatData, chatFile, false, handle, path.parse(avatarUrl).name, directories.backups, assertUnchanged);
        return { chat_id: chatId, message: reply };
    });
}
