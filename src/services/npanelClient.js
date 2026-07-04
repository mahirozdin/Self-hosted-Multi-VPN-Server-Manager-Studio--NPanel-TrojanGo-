const trojanApiService = require('./trojanApiService');

// Thin compatibility layer. The `buildCreateUserRequest` / `buildUpdateUserRequest`
// helpers describe NPanel's own (encrypted, unpublished) request framing and are
// kept for reference + unit tests. Real remote user sync is done through
// trojan-go's open gRPC API — see services/trojanApiService.js.
class NpanelClient {
  buildRequest(req, params = [], { token = '', key = 1 } = {}) {
    return {
      token,
      req,
      params: params.map((param) => String(param ?? '')),
      specialparam: 'req',
      key: String(key),
    };
  }

  buildCreateUserRequest(user, options = {}) {
    return this.buildRequest('create-user', [user.name], options);
  }

  buildUpdateUserRequest(user, options = {}) {
    return this.buildRequest('update-user', [
      user.name,
      user.password,
      user.speed_upload,
      user.speed_download,
      user.traffic_limit_max,
      user.ip_limit,
      user.enabled ? 1 : 0,
      user.days_left,
      user.day_limit ? 1 : 0,
      user.protocol,
      user.note || '',
      options.resetTraffic ? 0 : -1,
      options.resetTraffic ? 0 : -1,
    ], options);
  }

  // Reconcile one user on one server through the trojan-go API. Returns the shape
  // npanelUserService expects: { ok, status, message, hash, stats }.
  async syncUser(server, user) {
    const result = await trojanApiService.syncServerUsers(server, [user]);
    const applied = (result.applied && result.applied[0]) || null;
    if (!result.ok) {
      return {
        ok: false,
        status: 'trojan_api_error',
        message: result.error || 'trojan-go API sync failed',
        serverId: server.id,
        userName: user.name,
      };
    }
    const failed = applied && applied.action === 'error';
    return {
      ok: !failed,
      status: failed ? 'trojan_api_error' : 'synced',
      message: failed ? applied.message : `trojan-go user ${applied ? applied.action : 'synced'}`,
      serverId: server.id,
      userName: user.name,
      hash: applied ? applied.hash : trojanApiService.hash(user.password),
      stats: applied ? applied.stats : null,
    };
  }
}

module.exports = new NpanelClient();
