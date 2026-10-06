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

Set `"stream":true` to receive server-sent `delta`, `done`, and `error` events. Each `delta` has `{ "text": "..." }`; `done` is sent only after the completed turn is saved. An optional `request_id` (up to 200 characters) is stored with both messages and makes retries return the same answer without a second model call.

Configure a Chat Completion source in SillyTavern first. This endpoint supports OpenAI, OpenRouter, and Custom OpenAI-compatible sources, including the saved Custom URL, model, key, and YAML request additions. It reads the character card, existing chat overrides, selected global and character lorebooks, and chat lorebook. Lorebook activation covers constant entries, primary and secondary keywords, and before/after/chat-depth positions. It applies the global saved prompt order and enabled flags. Prompt assembly and context sizing are server-side approximations of the browser flow; browser extension prompts, advanced lorebook activation modes, character-specific prompt order, browser macro expansion, and Text Completion sources are not included.

Custom request headers can use server-only placeholders `${ENV:SILLYTAVERN_CUSTOM_API_KEY}` or `${SECRET:CUSTOM}`. The first reads that environment variable from the SillyTavern server process; the second reads its stored Custom API key. For example, `Authorization: "Api-Key ${ENV:SILLYTAVERN_CUSTOM_API_KEY}"` keeps the value out of `settings.json`. Only environment names beginning with `SILLYTAVERN_CUSTOM_` are accepted. Placeholders are resolved for this API and the normal Custom Chat Completion backend.

The endpoint uses the same user session, access restrictions, and CSRF protection as other private SillyTavern APIs. Obtain a token from `GET /csrf-token`, retain its session cookie, and send the token as `X-CSRF-Token` with the POST request.

## License

AGPL-3.0
