const axios = require('axios');

async function run() {
    const maxPolls = Number.parseInt(process.env.SMOKE_MAX_POLLS || '3', 10);
    const pollDelayMs = Number.parseInt(process.env.SMOKE_POLL_DELAY_MS || '1000', 10);

  const token = process.env.SMOKE_TOKEN;
  if (!token) {
    console.error('Missing SMOKE_TOKEN environment variable');
    process.exit(1);
  }

  const base = 'http://localhost:8080/api/admin/import';
  const endpoints = [
    ['artist', '/artist/702592?track_download=false'],
    ['album', '/album/14567221?track_download=false'],
    ['track', '/track/aRZbUYD7?track_download=false'],
    ['playlist', '/playlist/30793386?track_download=false'],
  ];

  const jobs = [];

  for (const [name, ep] of endpoints) {
    const url = `${base}${ep}`;
    console.log(`\n==== POST ${name.toUpperCase()} ${url} ====`);
    try {
      const response = await axios.post(
        url,
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 120000,
        }
      );

      console.log('Status:', response.status);
      console.log('Body:', JSON.stringify(response.data));

      if (response.data?.jobId) {
        jobs.push({ name, jobId: response.data.jobId });
      }
    } catch (error) {
      console.log('Status:', error.response?.status || 'NO_STATUS');
      console.log('Body:', JSON.stringify(error.response?.data || { message: error.message }));
    }
  }

  if (!jobs.length) {
    console.log('\nNo jobs queued; skipping status polling.');
    return;
  }

  console.log('\n==== POLLING JOB STATUS ====');

  for (const job of jobs) {
    const statusUrl = `${base}/status/${job.jobId}`;
    let finalState = null;

    for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
      try {
        const statusResponse = await axios.get(statusUrl, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 30000,
        });

        finalState = statusResponse.data;
        console.log(
          `[${job.name}] poll ${attempt}: status=${statusResponse.data?.status}, progress=${statusResponse.data?.progress}`
        );

        if (statusResponse.data?.status === 'success' || statusResponse.data?.status === 'failed') {
          break;
        }
      } catch (error) {
        console.log(
          `[${job.name}] poll ${attempt}: ${error.response?.status || 'NO_STATUS'} ${JSON.stringify(error.response?.data || { message: error.message })}`
        );
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }

    console.log(`[${job.name}] final:`, JSON.stringify(finalState));
  }
}

run().catch((error) => {
  console.error('Smoke test failed:', error.message);
  process.exit(1);
});
