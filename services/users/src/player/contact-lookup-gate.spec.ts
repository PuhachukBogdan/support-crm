import { PlayerReadController } from './player.grpc.controller';
import { REQUIRED_PLAYER_PERMISSION_KEY } from './requires-player-permission.decorator';

/**
 * W9 / spec 035 — the gate is `crm.contact.lookup`, structurally (unit calls bypass the guard, so
 * the decorator VALUE is the fact to pin — the same rule the W8 macro specs stated).
 *
 * ⛔ NOT `crm.contact.view`: every agent role holds that one, and riding it would grant the
 * anti-pitching inversion to the whole floor by construction (0044 §4).
 */
describe('the lookup gate', () => {
  const required = (method: object) => Reflect.getMetadata(REQUIRED_PLAYER_PERMISSION_KEY, method);

  it('LookupPlayerByContact requires crm.contact.lookup — its own key, nobody’s default', () => {
    expect(required(PlayerReadController.prototype.lookupPlayerByContact)).toBe('crm.contact.lookup');
  });

  it('and the neighbouring reads still ride the broad view key — the two are deliberately apart', () => {
    expect(required(PlayerReadController.prototype.getPlayer)).toBe('crm.contact.view');
    expect(required(PlayerReadController.prototype.listPlayersByBrand)).toBe('crm.contact.view');
  });
});
