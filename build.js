// build.js
const { buildVectorStore } = require("./vectorstore");

(async () => {
  try {
    await buildVectorStore();
    console.log("✅ Build complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
