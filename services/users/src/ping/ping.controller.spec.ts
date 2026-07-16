import { PingGrpcController } from './ping.controller';

// US3 / FR-007: the downstream handler echoes the message and stamps servedAt (so the
// gateway response proves the value originated here, not a local fake).
describe('users PingGrpcController', () => {
  it('echoes the message and stamps a valid ISO servedAt', () => {
    const controller = new PingGrpcController();
    const res = controller.ping({ message: 'hello' });
    expect(res.message).toBe('hello');
    expect(Number.isNaN(Date.parse(res.servedAt))).toBe(false);
  });
});
