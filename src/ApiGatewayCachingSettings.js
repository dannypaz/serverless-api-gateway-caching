const get = require('lodash.get');
const { Ignore, IgnoreWithWarning, Fail } = require('./UnauthorizedCacheControlHeaderStrategy');

const DEFAULT_CACHE_CLUSTER_SIZE = '0.5';
const DEFAULT_DATA_ENCRYPTED = false;
const DEFAULT_TTL = 3600;
const DEFAULT_UNAUTHORIZED_INVALIDATION_REQUEST_STRATEGY = IgnoreWithWarning;

const mapUnauthorizedRequestStrategy = strategy => {
  if (!strategy) {
    return DEFAULT_UNAUTHORIZED_INVALIDATION_REQUEST_STRATEGY;
  }
  switch (strategy.toLowerCase()) {
    case 'ignore': return Ignore;
    case 'ignorewithwarning': return IgnoreWithWarning;
    case 'fail': return Fail;
    default: return DEFAULT_UNAUTHORIZED_INVALIDATION_REQUEST_STRATEGY;
  }
}

const isApiGatewayEndpoint = event => {
  return event.http ? true : false;
}

const getApiGatewayResourceNameFor = (path, httpMethod) => {
  const pathElements = path.split('/');
  pathElements.push(httpMethod.toLowerCase());
  let gatewayResourceName = pathElements
    .map(element => {
      element = element.toLowerCase();
      element = element.replaceAll('+', '');
      element = element.replaceAll('_', '');
      element = element.replaceAll('.', '');
      element = element.replaceAll('-', 'Dash');
      if (element.startsWith('{')) {
        element = element.substring(element.indexOf('{') + 1, element.indexOf('}')) + "Var";
      }
      //capitalize first letter
      return element.charAt(0).toUpperCase() + element.slice(1);
    }).reduce((a, b) => a + b);

  gatewayResourceName = "ApiGatewayMethod" + gatewayResourceName;
  return gatewayResourceName;
}

class PerKeyInvalidationSettings {
  constructor(cachingSettings) {
    let { perKeyInvalidation } = cachingSettings;
    if (!perKeyInvalidation) {
      this.requireAuthorization = true;
      this.handleUnauthorizedRequests = DEFAULT_UNAUTHORIZED_INVALIDATION_REQUEST_STRATEGY;
    }
    else {
      this.requireAuthorization = perKeyInvalidation.requireAuthorization
      if (perKeyInvalidation.requireAuthorization) {
        this.handleUnauthorizedRequests =
          mapUnauthorizedRequestStrategy(perKeyInvalidation.handleUnauthorizedRequests);
      }
    }
  }
}

class ApiGatewayEndpointCachingSettings {
  constructor(functionName, event, globalSettings) {
    this.functionName = functionName;

    if (typeof (event.http) === 'string') {
      let parts = event.http.split(' ');
      this.method = parts[0];
      this.path = parts[1];
    }
    else {
      this.path = event.http.path;
      this.method = event.http.method;
    }

    if (this.path.endsWith('/') && this.path.length > 1) {
      this.path = this.path.slice(0, -1);
    }

    this.gatewayResourceName = getApiGatewayResourceNameFor(this.path, this.method);

    let { basePath } = globalSettings;
    if (basePath) {
      if (!basePath.startsWith('/')) {
        basePath = '/'.concat(basePath);
      }
      if (basePath.endsWith('/')) {
        basePath = basePath.slice(0, -1);
      }
      this.pathWithoutGlobalBasePath = this.path;
      this.path = basePath.concat(this.path);
    }

    if (!event.http.caching) {
      this.cachingEnabled = false;
      return;
    }
    let cachingConfig = event.http.caching;
    this.cachingEnabled = globalSettings.cachingEnabled ? cachingConfig.enabled : false;
    this.dataEncrypted = cachingConfig.dataEncrypted || globalSettings.dataEncrypted;
    this.cacheTtlInSeconds = cachingConfig.ttlInSeconds >= 0 ? cachingConfig.ttlInSeconds : globalSettings.cacheTtlInSeconds;
    this.cacheKeyParameters = cachingConfig.cacheKeyParameters;

    if (!cachingConfig.perKeyInvalidation) {
      this.perKeyInvalidation = globalSettings.perKeyInvalidation;
    } else {
      this.perKeyInvalidation = new PerKeyInvalidationSettings(cachingConfig);
    }
  }
}

class ApiGatewayAdditionalEndpointCachingSettings {
  constructor(method, path, caching, globalSettings) {
    this.method = method;
    this.path = path;
    
    this.gatewayResourceName = getApiGatewayResourceNameFor(this.path, this.method);

    if (!caching) {
      this.cachingEnabled = false;
      return;
    }
    const cachingConfig = caching;
    this.cachingEnabled = globalSettings.cachingEnabled ? cachingConfig.enabled : false;
    this.dataEncrypted = cachingConfig.dataEncrypted || globalSettings.dataEncrypted;
    this.cacheTtlInSeconds = caching.ttlInSeconds >= 0 ? caching.ttlInSeconds : globalSettings.cacheTtlInSeconds;
    this.cacheKeyParameters = cachingConfig.cacheKeyParameters;

    if (!cachingConfig.perKeyInvalidation) {
      this.perKeyInvalidation = globalSettings.perKeyInvalidation;
    } else {
      this.perKeyInvalidation = new PerKeyInvalidationSettings(cachingConfig);
    }
  }
}

class ApiGatewayCachingSettings {
  constructor(serverless, options) {
    if (!get(serverless, 'service.custom.apiGatewayCaching')) {
      return;
    }
    const cachingSettings = serverless.service.custom.apiGatewayCaching;
    this.cachingEnabled = cachingSettings.enabled;
    this.apiGatewayIsShared = cachingSettings.apiGatewayIsShared;
    this.restApiId = cachingSettings.restApiId;
    this.basePath = cachingSettings.basePath;

    if (options) {
      this.stage = options.stage || serverless.service.provider.stage;
      this.region = options.region || serverless.service.provider.region;
    } else {
      this.stage = serverless.service.provider.stage;
      this.region = serverless.service.provider.region;
    }

    this.endpointSettings = [];
    this.additionalEndpointSettings = [];

    this.cacheClusterSize = cachingSettings.clusterSize || DEFAULT_CACHE_CLUSTER_SIZE;
    this.cacheTtlInSeconds = cachingSettings.ttlInSeconds >= 0 ? cachingSettings.ttlInSeconds : DEFAULT_TTL;
    this.dataEncrypted = cachingSettings.dataEncrypted || DEFAULT_DATA_ENCRYPTED;

    this.perKeyInvalidation = new PerKeyInvalidationSettings(cachingSettings);

    for (let functionName in serverless.service.functions) {
      let functionSettings = serverless.service.functions[functionName];
      for (let event in functionSettings.events) {
        if (isApiGatewayEndpoint(functionSettings.events[event])) {
          this.endpointSettings.push(new ApiGatewayEndpointCachingSettings(functionName, functionSettings.events[event], this))
        }
      }
    }

    const additionalEndpoints = cachingSettings.additionalEndpoints || [];
    for (let additionalEndpoint of additionalEndpoints) {
      const { method, path, caching } = additionalEndpoint;
      this.additionalEndpointSettings.push(new ApiGatewayAdditionalEndpointCachingSettings(method, path, caching, this))
    }
  }
}

module.exports = ApiGatewayCachingSettings
