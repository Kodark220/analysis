'use strict';

const { handleDiscoveryRequest } = require('../server');

module.exports = async (request, response) => {
    if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
        response.statusCode = 204;
        response.end();
        return;
    }

    await handleDiscoveryRequest(request, response);
};
