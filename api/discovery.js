'use strict';

const { handleDiscoveryRequest } = require('../server');

module.exports = async (request, response) => {
    try {
        if (request.method === 'OPTIONS') {
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
            response.statusCode = 204;
            response.end();
            return;
        }

        await handleDiscoveryRequest(request, response);
    } catch (error) {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({
            error: error && error.message ? error.message : 'Discovery function failed.'
        }));
    }
};
