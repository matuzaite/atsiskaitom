// Vercel serverless entry point.
//
// Vercel treats files under /api as serverless functions. An Express app is
// itself a (req, res) handler, so we just re-export it. vercel.json rewrites
// every /api/* request to this function; Express matches the original path.
import app from "../server/index.js";

export default app;
