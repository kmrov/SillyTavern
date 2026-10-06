# SillyTavern

LLM Frontend for Power Users

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## Character chat API

`POST /api/characters/chat` sends one message to a stored character and saves both sides of the conversation in a normal SillyTavern chat. Use the `character_id` returned by `POST /api/characters/all`:

```json
{"character_id":"Mira","message":"Hello","chat_id":"my-conversation"}
```

The response is `{"chat_id":"my-conversation","message":"Hello back"}`. `character_id` is the PNG filename without `.png` (`Mira.png` becomes `Mira`); it changes when the character file is renamed. Existing clients may still send `avatar_url` instead. `chat_id` is optional; it defaults to `external-api`, a separate chat per character. Supply a different `chat_id` for each independent conversation. Existing chat IDs can be reused. Chat history stays on the SillyTavern side. If the chat changes while the model is replying, the endpoint returns HTTP 409 without saving its turn; retry the message.

Configure a Chat Completion source in SillyTavern first. This endpoint supports OpenAI, OpenRouter, and Custom OpenAI-compatible sources, including the saved Custom URL, model, key, and YAML request additions. It reads the character card, existing chat overrides, selected global and character lorebooks, and chat lorebook. Lorebook activation covers constant entries, primary and secondary keywords, and before/after/chat-depth positions. It applies the global saved prompt order and enabled flags. Prompt assembly and context sizing are server-side approximations of the browser flow; browser extension prompts, advanced lorebook activation modes, character-specific prompt order, browser macro expansion, and Text Completion sources are not included.

The endpoint uses the same user session, access restrictions, and CSRF protection as other private SillyTavern APIs. Obtain a token from `GET /csrf-token`, retain its session cookie, and send the token as `X-CSRF-Token` with the POST request.

## License

AGPL-3.0
