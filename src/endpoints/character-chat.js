import express from 'express';

import { CharacterChatError, sendCharacterMessage, streamCharacterMessage } from '../character-chat.js';

export const router = express.Router();

/** POST /api/characters/chat — one persisted turn with a stored character. */
export async function handleCharacterChat(request, response) {
    const input = {
        directories: request.user.directories,
        handle: request.user.profile.handle,
        characterId: request.body?.character_id,
        avatarUrl: request.body?.avatar_url,
        chatId: request.body?.chat_id,
        message: request.body?.message,
        requestId: request.body?.request_id,
    };
    if (request.body?.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        let answer = '';
        try {
            for await (const delta of streamCharacterMessage(input)) {
                answer += delta;
                if (!response.destroyed) response.write(`event: delta\ndata: ${JSON.stringify({ text: delta })}\n\n`);
            }
            if (!response.destroyed) response.write(`event: done\ndata: ${JSON.stringify({ chat_id: input.chatId || 'external-api', message: answer })}\n\n`);
        } catch (error) {
            if (!response.destroyed) response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        }
        if (!response.destroyed) response.end();
        return;
    }
    try {
        const result = await sendCharacterMessage(input);
        return response.json(result);
    } catch (error) {
        if (error instanceof CharacterChatError) {
            return response.status(error.status).json({ error: error.message });
        }
        console.error('Character chat failed:', error);
        return response.status(502).json({ error: 'Character chat generation failed.' });
    }
}

router.post('/', handleCharacterChat);
