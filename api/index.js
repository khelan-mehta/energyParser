/* Vercel serverless entry — exports the shared Express app as a function.
   vercel.json routes every /api/* request here. No app.listen on Vercel. */
import app from "../server/app.js";

export default app;
