import "dotenv/config";
import express from "express";
import webhookRouter from "./routes/webhook";

const app = express();

// Parse JSON bodies (Airtable Automation sends JSON)
app.use(express.json({ limit: "1mb" }));

// Mount routes
app.use("/api", webhookRouter);

// Root health check
app.get("/", (_req, res) => {
  res.json({
    service: "airtable-box-webhook",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Local dev server (not used on Vercel — Vercel imports the Express app directly)
if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Webhook endpoint: http://localhost:${port}/api/webhook`);
    console.log(`Health check:     http://localhost:${port}/api/health`);
  });
}

// Vercel expects a default export of the Express app
export default app;
