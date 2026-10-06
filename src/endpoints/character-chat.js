import express from 'express';

import { CharacterChatError, sendCharacterMessage } from '../character-chat.js';

export const router = express.Router();

/** POST /api/characters/chat — one persisted turn with a stored character. */
export async function handleCharacterChat(request, response) {
    try {
        const result = await sendCharacterMessage({
            directories: request.user.directories,
            handle: request.user.profile.handle,
            characterId: request.body?.character_id,
            avatarUrl: request.body?.avatar_url,
            chatId: request.body?.chat_id,
            message: request.body?.message,
        });
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
