# @tracebloom/sdk

Thin TypeScript SDK that emits OpenTelemetry `gen_ai` spans for LLM calls to the
TraceBloom collector (OTLP/HTTP, protobuf).

```ts
import OpenAI from 'openai';
import { init, instrumentOpenAI } from '@tracebloom/sdk';

init({
  endpoint: 'http://localhost:4318', // TraceBloom collector
  serviceName: 'my-app',
  // captureContent: true,            // record prompt/response as span events (off by default)
});

const openai = instrumentOpenAI(new OpenAI());

// Every chat.completions.create call now emits a gen_ai CLIENT span with the
// model, token usage, computed cost, latency and status.
await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

- **Provider-agnostic:** wraps any `chat.completions.create`-shaped client.
- **Cost:** computed from an editable per-model pricing map (`init({ pricing })`).
- **Content safety:** prompt/response content is emitted as span *events* and is
  off by default, enable with `captureContent` or `TRACEBLOOM_CAPTURE_CONTENT=1`.

See [DECISIONS.md](../../DECISIONS.md) for the wire-format and content-capture rationale.
