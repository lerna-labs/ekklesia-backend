import { jest } from '@jest/globals';

await jest.unstable_mockModule('../helper/loadRoutes.js', () => ({
  loadRoutes: jest.fn().mockRejectedValue(new Error('route import failed')),
}));

await jest.unstable_mockModule('../helper/dbManager.js', () => ({
  connectToDatabase: jest.fn().mockResolvedValue(undefined),
  isDatabaseConnected: () => true,
  checkDatabaseConnectionMW: (req, res, next) => next(),
}));

await jest.unstable_mockModule('../helper/envLoader.js', () => ({
  loadEnvironmentVariables: jest.fn(),
}));

await jest.unstable_mockModule('../helper/envOverlay.js', () => ({
  loadLocalOverrides: jest.fn(),
}));

describe('server startup', () => {
  test('exits non-zero when route loading fails', async () => {
    process.env.JWT_SECRET = 'x'.repeat(40);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await import('../server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
