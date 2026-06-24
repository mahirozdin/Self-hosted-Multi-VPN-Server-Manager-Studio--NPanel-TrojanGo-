class NpanelClient {
  constructor() {
    this.protocolStatus = 'encrypted_protocol_adapter_missing';
  }

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

  async syncUser(server, user) {
    const createPayload = this.buildCreateUserRequest(user, { key: 1 });
    const updatePayload = this.buildUpdateUserRequest(user, { key: 2 });

    return {
      ok: false,
      status: this.protocolStatus,
      message:
        'NPanel create-user/update-user request payloads were prepared, but upstream cEnc/cDec AES binary framing is not published as source. Local desired state and configs were generated; remote creation requires a cipher adapter or manual NPanel sync.',
      serverId: server.id,
      userName: user.name,
      plannedRequests: [createPayload.req, updatePayload.req],
    };
  }
}

module.exports = new NpanelClient();
