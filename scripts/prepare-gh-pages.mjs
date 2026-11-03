import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const basePath = (process.env.BASE_PATH || "/PS2SP").replace(/\/$/, "");

if (!fs.existsSync(distDir)) {
  console.error("dist directory does not exist.");
  process.exit(1);
}

// 1. Create .nojekyll so GitHub Pages serves directories and assets starting with underscore (_astro)
fs.writeFileSync(path.join(distDir, ".nojekyll"), "");
console.log("Created dist/.nojekyll");

// 2. Create 404.html from index.html if it doesn't exist
const indexPath = path.join(distDir, "index.html");
const notFoundPath = path.join(distDir, "404.html");
if (fs.existsSync(indexPath) && !fs.existsSync(notFoundPath)) {
  fs.copyFileSync(indexPath, notFoundPath);
  console.log("Created dist/404.html fallback");
}

// 3. Walk through all .html, .js, and .json files in dist to prefix any remaining root-relative URLs
function walk(dir, callback) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, callback);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".html") || entry.name.endsWith(".js") || entry.name.endsWith(".json"))
    ) {
      callback(fullPath);
    }
  }
}

if (basePath) {
  let patchedCount = 0;
  walk(distDir, (filePath) => {
    let content = fs.readFileSync(filePath, "utf8");
    let changed = false;

    if (filePath.endsWith(".html")) {
      // Replace href="/...", src="/...", action="/..." if not already prefixed
      const nextContent = content.replace(/(href|src|action)="\/([^"]*)"/g, (match, attr, target) => {
        if (target.startsWith("/") || target.startsWith(basePath.slice(1) + "/") || target === basePath.slice(1)) {
          return match;
        }
        return `${attr}="${basePath}/${target}"`;
      });
      if (nextContent !== content) {
        content = nextContent;
        changed = true;
      }
    }

    if (filePath.endsWith(".js") || filePath.endsWith(".html")) {
      // Fix API endpoints like fetch("/api/...") or next: "/api/..."
      const nextContent = content.replace(/(["'`])\/api\/([^"'`]*)\1/g, (match, quote, rest) => {
        if (basePath && !rest.startsWith(basePath.slice(1))) {
          return `${quote}${basePath}/api/${rest}${quote}`;
        }
        return match;
      });
      if (nextContent !== content) {
        content = nextContent;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, content, "utf8");
      patchedCount++;
    }
  });
  console.log(`Prepared GitHub Pages build: patched ${patchedCount} files with base path ${basePath}`);
}
