import "dotenv/config";
import mongoose from "mongoose";
import { CaseStudy } from "@ai-interview/db";

const caseStudies = [
 

  // Add more case studies here after running the conversion prompt.
  // Each entry must match the schema above exactly.
];

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[Seed] Connected to MongoDB");

  let inserted = 0;
  let updated = 0;

  for (const data of caseStudies) {
    const existing = await CaseStudy.findOne({ slug: data.slug });
    await CaseStudy.findOneAndUpdate({ slug: data.slug }, data, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    if (existing) {
      updated++;
      console.log(`[Seed] Updated:  ${data.title}`);
    } else {
      inserted++;
      console.log(`[Seed] Inserted: ${data.title}`);
    }
  }

  console.log(`[Seed] Done — ${inserted} inserted, ${updated} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("[Seed] Failed:", err);
  process.exit(1);
});
