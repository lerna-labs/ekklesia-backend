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

// ping Hydra on voter login
export async function hydraVoterPing(userId) {
  // return if no userId is present
  if (!userId) {
    if (verbose) console.error('hydraVoterPing: Voter ID is required');
    return;
  }

  // return if HYDRA_URL is not set
  if (!process.env.HYDRA_URL) {
    if (verbose) console.error('hydraVoterPing: HYDRA_URL is not set, skipping ping');
    return;
  }

  // return if HYDRA_TOKEN is not set
  if (!process.env.HYDRA_TOKEN) {
    if (verbose) console.error('hydraVoterPing: HYDRA_TOKEN is not set, skipping ping');
    return;
  }

  // ping Hydra
  if (verbose) console.log('Pinging Hydra for userId:', userId);
  try {
    fetch(`${process.env.HYDRA_URL}/register`, {
      method: 'POST',
      headers: {
        'x-api-key': `${process.env.HYDRA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
      }),
    });
    const data = await response.json();
    if (verbose) console.log('Hydra response:', data);
    return data;
  } catch (error) {
    if (verbose) console.error(`Failed to ping Hydra: ${error.message}`);
    return null;
  }
}
