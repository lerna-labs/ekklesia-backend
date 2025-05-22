import { ScriptHash } from "@emurgo/cardano-serialization-lib-nodejs";

export async function getScript(scriptHash) {
  const API_URL = process.env.API_URL;
  const API_TOKEN = process.env.API_TOKEN;
  if (!API_URL) {
    console.error("API_URL is not set in the environment variables.");
    throw new Error("API URL is not set!");
  }

  if (!API_TOKEN) {
    console.error("API_TOKEN is not set in the environment variables.");
    throw new Error("API Token is not set!");
  }

  let script_hash;
  try {
    script_hash = ScriptHash.from_hex(scriptHash);
  } catch (error) {
    console.error(`Not a valid script hash: ${script_hash}`);
    throw new Error("Not a valid script hash");
  }

  try {
    const scripts = await fetch(API_URL + "/script_info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "count=exact",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({ _script_hashes: [scriptHash] }),
    });

    const script_data = await scripts.json();
    // TODO: Cache the fetched/returned script data so we can save on calls to Koios in the future
    if (script_data.length > 0) {
      return script_data[0];
    }
    return false;
  } catch (error) {
    console.log("Error fetching script hash:", scriptHash);
    console.error(error);
  }

  return false;
}
