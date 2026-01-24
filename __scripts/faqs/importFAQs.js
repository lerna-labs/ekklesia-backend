import { FAQ } from "../../schema/FAQ.js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFile } from "fs/promises";
import {
    connectToDatabase,
    disconnectFromDatabase,
} from "../../helper/dbManager.js";

// Parse command line arguments
let env = "development"; // Default environment

// Get the directory path for relative file references
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables based on the specified environment
const envPath = join(__dirname, "..", "..", `.env.${env}`);
console.log(`Loading environment from: ${envPath}`);
dotenv.config({ path: envPath });

await connectToDatabase();

console.log("Starting FAQ import...");
console.time("FAQ import completed in");

try {
    // Read the FAQs JSON file
    const faqsPath = join(__dirname, "faqs.json");
    const faqsData = await readFile(faqsPath, "utf-8");
    const faqs = JSON.parse(faqsData);

    console.log(`Found ${faqs.length} FAQs to import`);

    // Map and save FAQs
    const faqsToSave = faqs.map((faq) => ({
        title: faq.title,
        content: faq.content,
        tags: faq.tags || ["Voting"],
        featured: faq.featured || false,
        is_live: true,
    }));

    // Insert FAQs into the database
    const result = await FAQ.insertMany(faqsToSave, { ordered: false });

    console.log(`Successfully imported ${result.length} FAQs`);
    console.log("FAQs imported with tags from JSON and is_live set to true");

    console.timeEnd("FAQ import completed in");
} catch (error) {
    if (error.code === 11000) {
        console.error("Error: Some FAQs may already exist in the database");
    } else {
        console.error("Error during FAQ import:", error);
    }
    process.exit(1);
}

await disconnectFromDatabase();
console.log("Disconnected from database");

process.exit(0);
