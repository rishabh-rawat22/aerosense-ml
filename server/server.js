require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");
const logger = require("./config/logger");
const { apiLimiter } = require("./middleware/rateLimiter");
const authRoutes = require("./routes/authRoutes");
const aqiRoutes = require("./routes/aqiRoutes");

// Connect to MongoDB then start the CPCB hourly sync
connectDB().then(() => {
  const { startCronJob } = require("./jobs/syncCPCB");
  startCronJob();

  // Start AQI email alert cron (checks every 3h in prod, every min in dev)
  const { startAqiAlertCron } = require("./jobs/aqiAlertCron");
  startAqiAlertCron({
    runImmediately: process.env.NODE_ENV === "development",
  });

  // Self-ping every 14 minutes to prevent Render free tier sleep
  setInterval(
    () => {
      const http = require("http");
      const port = process.env.PORT || 5000;
      http
        .get(`http://localhost:${port}/api/health`, (res) => {
          logger.info(`Self-ping OK: ${res.statusCode}`);
        })
        .on("error", (err) => {
          logger.warn(`Self-ping failed: ${err.message}`);
        });

      // Also ping the ML microservice to keep its scheduler alive
      if (process.env.ML_SERVICE_URL) {
        const https = require("https");
        const mlHealthUrl = process.env.ML_SERVICE_URL.replace("/predict", "/health");
        
        const req = mlHealthUrl.startsWith("https") ? https : http;
        req
          .get(mlHealthUrl, (res) => {
            logger.info(`ML-ping OK: ${res.statusCode}`);
          })
          .on("error", (err) => {
            logger.warn(`ML-ping failed: ${err.message}`);
          });
      }
    },
    14 * 60 * 1000,
  );
});

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: ["http://localhost:3000", process.env.CLIENT_URL].filter(Boolean),
    credentials: true,
  }),
);

// ── Logging & Parsing ─────────────────────────────────────────────────────────
app.use(
  morgan("combined", { stream: { write: (m) => logger.info(m.trim()) } }),
);
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
app.use("/api", apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/aqi", aqiRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Aerosense API running 🌿",
    environment: process.env.NODE_ENV,
    dataSource: "WAQI — aqicn.org",
    mlModel: process.env.ML_SERVICE_URL ? "connected" : "pending_integration",
    timestamp: new Date().toISOString(),
  });
});

// 404 Handler
app.use((req, res) => {
  res
    .status(404)
    .json({ success: false, error: `Route ${req.originalUrl} not found.` });
});

// Global Error Handler
app.use((err, req, res, next) => {
  logger.error(err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error."
        : err.message,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚀 Aerosense server on port ${PORT} [${process.env.NODE_ENV}]`);
  logger.info(`📡 Data source: WAQI (aqicn.org)`);
});

module.exports = app;