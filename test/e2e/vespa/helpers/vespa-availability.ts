async function probeVespaHealth(vespaUrl: string | undefined): Promise<boolean> {
  if (vespaUrl === undefined || vespaUrl.length === 0) {
    return false;
  }

  try {
    const response = await fetch(`${vespaUrl}/state/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export const HAS_REACHABLE_VESPA = await probeVespaHealth(process.env['VESPA_URL']);
