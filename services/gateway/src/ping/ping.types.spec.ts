import { PingRequest, PingResponse } from '@crm/proto';
import { makeSamplePing } from './ping.sample';

// US4: FAILS until `npm run proto:gen` has produced the ts-proto stubs and they import
// cleanly into this service; PASSES once the generated types build and round-trip.
describe('generated proto stubs (@crm/proto)', () => {
  it('imports the generated message types and constructs values', () => {
    const req: PingRequest = { message: 'hello' };
    const res: PingResponse = makeSamplePing(req);

    expect(res.message).toBe('hello');
    expect(typeof res.servedAt).toBe('string');
    // ISO-8601 round-trips through Date without becoming Invalid Date.
    expect(Number.isNaN(Date.parse(res.servedAt))).toBe(false);
  });
});
