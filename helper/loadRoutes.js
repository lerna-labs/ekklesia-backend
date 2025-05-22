import fs from "fs/promises";
import { dirname, join } from "path";

/**
 * Recursively loads route files from a directory and registers them with the Express app
 *
 * @param {string} directory - The base directory to search for route files
 * @param {object} app - The Express application instance
 * @param {string} baseRoute - The base route path (used for recursion)
 * @returns {Promise<void>}
 */
export async function loadRoutes(directory, app, baseRoute = "") {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        // If it's a directory, recursively load routes from it
        const nextBaseRoute = join(baseRoute, entry.name).replace(/\\/g, "/");
        await loadRoutes(fullPath, app, nextBaseRoute);
      } else if (entry.name.endsWith(".js") && entry.name !== "index.js") {
        // If it's a JS file (excluding index.js files)
        const routeName = entry.name.replace(".js", "");
        const routePath = `/${baseRoute}/${routeName}`.replace(/\/+/g, "/");

        // Use dynamic import for ESM compatibility
        const routeModule = await import(`file://${fullPath}`);
        const router = routeModule.default;

        if (router && typeof router.use === "function") {
          console.log(`Route loaded: ${routePath}`);
          app.use(routePath, router);
        }
      }
    }
  } catch (error) {
    console.log(error);
    console.error(`Error loading routes: ${error.message}`);
  }
}
