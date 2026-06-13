import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import analyzeRouter from "./routes/analyze";

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:3000" }));
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api", analyzeRouter);

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[Server] Unhandled error:", err.message);
    res.status(500).json({ error: err.message });
  }
);

app.listen(PORT, () => {
  console.log(`✅ FactCheck backend running on http://localhost:${PORT}`);
  console.log(`   NLP service expected at: ${process.env.NLP_SERVICE_URL ?? "http://localhost:5001"}`);
});

export default app;