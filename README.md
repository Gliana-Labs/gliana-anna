# GlianaAI on Anna

An [Anna AI](https://anna.partners) app that puts [GlianaAI](https://ai.glianalabs.com) (one pay-per-call API for 170+
models and tools) inside Anna, with an AI planner in front.

1. Describe what you want ("a 5-second video of a lighthouse at dusk", "an Indonesian voice-over of this text",
   "30 seconds of lo-fi music", "a screenshot of this page"). Attach an image to edit or animate it.
2. Anna's LLM (the user's Anna credits) picks one model or tool from the live GlianaAI catalogue and writes its input
   from the model's schema or the tool's example.
3. The app shows the plan and the exact price from `GET /v1/price` before anything runs.
4. The run is paid from the user's own GlianaAI balance with their `gk_` key (BYOK): `POST /v1/infer` for models, the
   tool's own path for tools. The result (image, video, audio or data), the charge and the balance appear in the window.

Offered: image, video, voice and music models, and every tool payable from a balance. Left out on purpose:
uncensored/abliterated models, and tools that take personal data (KTP/NIK/NPWP, faces, KYC, people lookups).

## Layout

```
app/manifest.json      schema 4, bundle-only; external origin + media-src https://api.glianalabs.com
app/app.json           store listing
app/bundle/            index.html, app.js (host + network), logic.js (pure, tested), style.css
app/fixtures/          mock LLM reply for the local harness (one reply serves both planning calls:
                       anna-app 0.1.68's mock matches String(messages), so contentIncludes never matches)
test/logic.test.mjs    node --test
listing/               logo and screenshot
```

## Develop

```bash
npm install && npm test
cd app && npx anna-app validate --strict
npx anna-app dev --mock-llm fixtures/replies.jsonl   # http://localhost:5180/
```
