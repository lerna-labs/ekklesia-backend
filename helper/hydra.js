// set console log output
const verbose = false;

// get Hydra status
export async function hydraGetStatus() {
  // return if HYDRA_URL is not set
  if (!process.env.HYDRA_URL) {
    if (verbose) console.error('hydraStatus: HYDRA_URL is not set, skipping status check');
    return;
  }

  // return if HYDRA_TOKEN is not set
  if (!process.env.HYDRA_TOKEN) {
    if (verbose) console.error('hydraStatus: HYDRA_TOKEN is not set, skipping status check');
    return;
  }

  try {
    const response = await fetch(`${process.env.HYDRA_URL}/health`, {
      headers: {
        'x-api-key': `${process.env.HYDRA_TOKEN}`,
      },
    });
    const data = await response.json();
    return data.status || 'unknown';
  } catch (error) {
    if (verbose) console.error(`Failed to check Hydra status: ${error.message}`);
    return 'not available';
  }
}
