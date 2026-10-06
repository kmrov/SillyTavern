/* eslint playwright/expect-expect: off */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { write } from '../src/character-card-parser.js';
import { DEFAULT_AVATAR_PATH } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-chat-'));
fs.writeFileSync(path.join(root, 'config.yaml'), '{}');
setConfigFilePath(path.join(root, 'config.yaml'));
const directories = Object.fromEntries(['root', 'characters', 'chats', 'worlds', 'backups'].map(name => [name, path.join(root, name)]));
for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });

const card = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'Mira', description: 'A librarian who guards old maps.', personality: 'Patient',
        scenario: 'Inside a quiet library.', first_mes: 'Welcome to the library.',
        mes_example: '', system_prompt: 'Stay in character.', post_history_instructions: '',
        tags: [], creator: '', character_version: '', alternate_greetings: [],
        extensions: { world: 'Library Lore' },
    },
};
fs.writeFileSync(path.join(directories.characters, 'Mira.png'), write(fs.readFileSync(DEFAULT_AVATAR_PATH), JSON.stringify(card)));
fs.writeFileSync(path.join(directories.worlds, 'Library Lore.json'), JSON.stringify({ entries: {
    1: { key: ['atlas'], keysecondary: [], content: 'The atlas is hidden in the west wing.', order: 100, position: 0, disable: false, constant: false },
    2: { key: ['atlas'], keysecondary: [], content: 'Its cover is blue.', order: 90, position: 4, depth: 1, role: 0, disable: false, constant: false },
    3: { key: ['atlas'], keysecondary: ['missing phrase'], selective: false, content: 'The atlas is old.', order: 80, position: 0, disable: false, constant: false },
} }));

let chatService;
const modelRequests = [];
let modelShouldFail = false;

before(async () => {
    chatService = await import('../src/character-chat.js');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function saveSettings() {
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        main_api: 'openai', username: 'Visitor',
        oai_settings: {
            chat_completion_source: 'custom', custom_model: 'test-model', custom_url: 'http://example.invalid/v1',
            openai_max_tokens: 100, openai_max_context: 4096, temp_openai: 0.7, top_p_openai: 1,
            prompts: [{ identifier: 'main', content: 'Write the next reply as {{char}}.' }],
        },
        world_info_settings: { world_info: { globalSelect: [] }, world_info_depth: 2, world_info_case_sensitive: false, world_info_match_whole_words: true },
    }));
}

async function send(body) {
    return chatService.sendCharacterMessage({
        directories, handle: 'test', characterId: body.character_id, avatarUrl: body.avatar_url, chatId: body.chat_id,
        message: body.message,
        generate: async payload => {
            modelRequests.push(payload);
            if (modelShouldFail) throw new Error('Model unavailable');
            return 'The west wing is this way.';
        },
    });
}

test('a character message uses the stored card and activated lore, then saves a regular SillyTavern chat', async () => {
    saveSettings();
    const result = await send({ character_id: 'Mira', message: 'Where is the atlas?' });
    assert.equal(result.chat_id, 'external-api');
    assert.equal(result.message, 'The west wing is this way.');
    const prompt = modelRequests.at(-1).messages;
    assert.match(prompt[0].content, /A librarian who guards old maps/);
    assert.match(prompt[0].content, /The atlas is hidden in the west wing/);
    assert.match(prompt[0].content, /The atlas is old/);
    assert.deepEqual(prompt.at(-1), { role: 'user', content: 'Where is the atlas?' });
    const saved = fs.readFileSync(path.join(directories.chats, 'Mira', 'external-api.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(saved[0].character_name, 'Mira');
    assert.equal(saved[1].mes, 'Welcome to the library.');
    assert.deepEqual(saved.slice(-2).map(x => [x.is_user, x.mes]), [[true, 'Where is the atlas?'], [false, 'The west wing is this way.']]);
});

test('the next turn includes the saved conversation and keeps lore inactive when its key is absent', async () => {
    modelRequests.length = 0;
    const result = await send({ avatar_url: 'Mira.png', message: 'Thank you.' });
    assert.equal(result.chat_id, 'external-api');
    const messages = modelRequests[0].messages;
    assert.doesNotMatch(messages[0].content, /The atlas is hidden/);
    assert.deepEqual(messages.slice(-3), [
        { role: 'user', content: 'Where is the atlas?' },
        { role: 'assistant', content: 'The west wing is this way.' },
        { role: 'user', content: 'Thank you.' },
    ]);
});

test('lorebook entries at chat depth are inserted near the latest message', async () => {
    modelRequests.length = 0;
    await send({ avatar_url: 'Mira.png', chat_id: 'depth-test', message: 'Show me the atlas.' });
    const messages = modelRequests[0].messages;
    assert.equal(messages.at(-2).role, 'system');
    assert.match(messages.at(-2).content, /Its cover is blue/);
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'Show me the atlas.' });
});

test('old turns are dropped when the selected model context is full', async () => {
    saveSettings();
    const settingsFile = path.join(directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.oai_settings.openai_max_context = 300;
    settings.oai_settings.openai_max_tokens = 50;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const chatFile = path.join(directories.chats, 'Mira', 'trim-test.jsonl');
    fs.writeFileSync(chatFile, [
        { chat_metadata: {}, user_name: 'Visitor', character_name: 'Mira' },
        { name: 'Visitor', is_user: true, mes: 'OLD MESSAGE ' + 'x'.repeat(1600) },
        { name: 'Mira', is_user: false, mes: 'Recent answer' },
    ].map(JSON.stringify).join('\n'));
    modelRequests.length = 0;
    await send({ avatar_url: 'Mira.png', chat_id: 'trim-test', message: 'Current question' });
    const prompt = modelRequests[0].messages;
    assert.equal(prompt.some(item => item.content.includes('OLD MESSAGE')), false);
    assert.equal(prompt.some(item => item.content === 'Recent answer'), true);
    assert.deepEqual(prompt.at(-1), { role: 'user', content: 'Current question' });
});

test('an oversized new message is rejected before calling the model or saving a chat', async () => {
    saveSettings();
    const settingsFile = path.join(directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.oai_settings.openai_max_context = 300;
    settings.oai_settings.openai_max_tokens = 50;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    modelRequests.length = 0;
    await assert.rejects(send({ avatar_url: 'Mira.png', chat_id: 'too-long', message: 'x'.repeat(2000) }), error => error.status === 413);
    assert.equal(modelRequests.length, 0);
    assert.equal(fs.existsSync(path.join(directories.chats, 'Mira', 'too-long.jsonl')), false);
});

test('high token density text is rejected when it exceeds the selected context', async () => {
    saveSettings();
    const settingsFile = path.join(directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.oai_settings.openai_max_context = 300;
    settings.oai_settings.openai_max_tokens = 50;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    modelRequests.length = 0;
    await assert.rejects(send({ avatar_url: 'Mira.png', chat_id: 'high-density', message: '你好世界'.repeat(100) }), error => error.status === 413);
    assert.equal(modelRequests.length, 0);
});

test('a malformed existing chat is not silently rewritten', async () => {
    saveSettings();
    const chatFile = path.join(directories.chats, 'Mira', 'damaged.jsonl');
    const original = `${JSON.stringify({ chat_metadata: {}, user_name: 'Visitor', character_name: 'Mira' })}\n{"broken`;
    fs.writeFileSync(chatFile, original);
    await assert.rejects(send({ avatar_url: 'Mira.png', chat_id: 'damaged', message: 'Hello' }), error => error.status === 422);
    assert.equal(fs.readFileSync(chatFile, 'utf8'), original);
});

test('a browser save during generation is preserved and the API turn is rejected', async () => {
    saveSettings();
    const chatFile = path.join(directories.chats, 'Mira', 'race-test.jsonl');
    const initial = [
        { chat_metadata: {}, user_name: 'Visitor', character_name: 'Mira' },
        { name: 'Visitor', is_user: true, mes: 'Original' },
    ];
    fs.writeFileSync(chatFile, initial.map(JSON.stringify).join('\n'));
    const browserVersion = [...initial, { name: 'Mira', is_user: false, mes: 'Browser reply' }].map(JSON.stringify).join('\n');
    await assert.rejects(chatService.sendCharacterMessage({
        directories, handle: 'test', avatarUrl: 'Mira.png', chatId: 'race-test', message: 'API message',
        generate: async () => {
            fs.writeFileSync(chatFile, browserVersion);
            return 'API reply';
        },
    }), error => error.status === 409);
    assert.equal(fs.readFileSync(chatFile, 'utf8'), browserVersion);
});

test('existing chat metadata overrides card fields and post-history instructions follow the history', async () => {
    saveSettings();
    const chatFile = path.join(directories.chats, 'Mira', 'overrides.jsonl');
    fs.writeFileSync(chatFile, JSON.stringify({
        chat_metadata: { system_prompt: 'A secret keeper.', scenario: 'In the tower.', mes_example: 'Mira: Hush.' },
        user_name: 'Visitor', character_name: 'Mira',
    }));
    modelRequests.length = 0;
    await send({ avatar_url: 'Mira.png', chat_id: 'overrides', message: 'Hello' });
    const messages = modelRequests[0].messages;
    assert.match(messages[0].content, /A secret keeper/);
    assert.match(messages[0].content, /In the tower/);
    assert.match(messages[0].content, /Mira: Hush/);
    assert.doesNotMatch(messages[0].content, /Stay in character|Inside a quiet library/);
});

test('saved prompt order can disable card sections and place post-history content after the conversation', async () => {
    saveSettings();
    const settingsFile = path.join(directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.oai_settings.prompts.push({ identifier: 'jailbreak', content: 'Finish the scene.' });
    settings.oai_settings.prompt_order = [{ character_id: 100000, order: [
        { identifier: 'main', enabled: true },
        { identifier: 'scenario', enabled: false },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
    ] }];
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    modelRequests.length = 0;
    await send({ avatar_url: 'Mira.png', chat_id: 'prompt-order', message: 'Hello' });
    const messages = modelRequests[0].messages;
    assert.match(messages[0].content, /A librarian who guards old maps/);
    assert.doesNotMatch(messages[0].content, /Inside a quiet library/);
    assert.deepEqual(messages.at(-2), { role: 'user', content: 'Hello' });
    assert.match(messages.at(-1).content, /Finish the scene/);
});

test('invalid character and chat IDs are rejected before writing chat files', async () => {
    await assert.rejects(send({ character_id: '../Mira', message: 'Hi' }), error => error.status === 400);
    await assert.rejects(send({ character_id: 'Other', avatar_url: 'Mira.png', message: 'Hi' }), error => error.status === 400);
    await assert.rejects(send({ character_id: 'Missing', message: 'Hi' }), error => error.status === 404);
    await assert.rejects(send({ avatar_url: '../Mira.png', message: 'Hi' }), error => error.status === 400);
    await assert.rejects(send({ avatar_url: 'Missing.png', message: 'Hi' }), error => error.status === 404);
    await assert.rejects(send({ avatar_url: 'Mira.png', chat_id: '../escape', message: 'Hi' }), error => error.status === 400);
    assert.equal(fs.existsSync(path.join(root, 'escape.jsonl')), false);
});

test('the character list exposes the filename stem as character_id', async () => {
    const { processCharacter } = await import('../src/endpoints/characters.js');
    const character = await processCharacter('Mira.png', directories, { shallow: true });
    assert.equal(character.character_id, 'Mira');
    assert.equal(character.avatar, 'Mira.png');
});

test('a failed model call leaves the conversation unchanged', async () => {
    const chatFile = path.join(directories.chats, 'Mira', 'external-api.jsonl');
    const beforeFailure = fs.readFileSync(chatFile, 'utf8');
    modelShouldFail = true;
    await assert.rejects(send({ avatar_url: 'Mira.png', message: 'Are you there?' }), /Model unavailable/);
    modelShouldFail = false;
    assert.equal(fs.readFileSync(chatFile, 'utf8'), beforeFailure);
});

test('the HTTP handler reports validation errors with their status', async () => {
    const { handleCharacterChat } = await import('../src/endpoints/character-chat.js');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    await handleCharacterChat({ user: { directories, profile: { handle: 'test' } }, body: { avatar_url: 'Mira.png', message: '' } }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /message/);
});

test('the selected Custom source sends its configured model, request fields and headers', async () => {
    saveSettings();
    const settings = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    settings.oai_settings.custom_include_body = 'min_p: 0.1';
    settings.oai_settings.custom_include_headers = 'X-Local-Model: enabled';
    settings.oai_settings.seed = 42;
    let sent;
    const reply = await chatService.generateWithStoredSettings({
        settings, directories, messages: [{ role: 'user', content: 'Hello' }],
    }, async (url, options) => {
        sent = { url: String(url), headers: options.headers, body: JSON.parse(options.body), signal: options.signal };
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Hello back' } }] }) };
    });
    assert.equal(reply, 'Hello back');
    assert.equal(sent.url, 'http://example.invalid/v1/chat/completions');
    assert.equal(sent.body.model, 'test-model');
    assert.equal(sent.body.min_p, 0.1);
    assert.equal(sent.body.seed, 42);
    assert.equal(sent.headers['X-Local-Model'], 'enabled');
    assert.equal(sent.signal instanceof AbortSignal, true);
});

test('OpenAI reasoning models receive their compatible token and sampling fields', async () => {
    saveSettings();
    const settings = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    settings.oai_settings.chat_completion_source = 'openai';
    settings.oai_settings.openai_model = 'gpt-5';
    settings.oai_settings.reverse_proxy = 'http://example.invalid/v1';
    settings.oai_settings.proxy_password = 'test';
    let body;
    await chatService.generateWithStoredSettings({ settings, directories, messages: [{ role: 'user', content: 'Hello' }] },
        async (_url, options) => {
            body = JSON.parse(options.body);
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hi' } }] }) };
        });
    assert.equal(body.max_completion_tokens, 100);
    assert.equal('max_tokens' in body, false);
    assert.equal('temperature' in body, false);
    assert.equal('top_p' in body, false);
});
