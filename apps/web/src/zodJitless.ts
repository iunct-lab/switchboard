import { z } from "zod";

// The CSP rejects eval, so zod's `new Function` probe would log a security entry. Evaluated first in main.tsx, before @switchboard/protocol builds its schemas.
z.config({ jitless: true });
