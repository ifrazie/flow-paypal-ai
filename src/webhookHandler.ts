import type { Request, Response } from "express";
import type { IncomingHttpHeaders } from "node:http";

export function createWebhookHandler(options: {
  webhookId?: string;
  verify: (headers: IncomingHttpHeaders, event: unknown, webhookId: string) => Promise<boolean>;
  onVerified: () => void;
}) {
  return async (req: Request, res: Response) => {
    if (!options.webhookId) { res.status(503).json({ error: "Webhook verification is not configured." }); return; }
    try {
      if (!await options.verify(req.headers, req.body, options.webhookId)) { res.sendStatus(401); return; }
      options.onVerified();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: "Webhook verification unavailable." });
    }
  };
}
