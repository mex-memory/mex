import express from "express";

const app = express();

export function healthHandler(_req: unknown, _res: unknown): void {}

app.get("/health", healthHandler);
