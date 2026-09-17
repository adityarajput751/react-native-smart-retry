"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "AppLifecycleManager", {
  enumerable: true,
  get: function () {
    return _AppLifecycleManager.AppLifecycleManager;
  }
});
Object.defineProperty(exports, "AsyncStorageStorage", {
  enumerable: true,
  get: function () {
    return _AsyncStorageStorage.AsyncStorageStorage;
  }
});
Object.defineProperty(exports, "DEFAULT_NON_RETRYABLE_STATUS_CODES", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.DEFAULT_NON_RETRYABLE_STATUS_CODES;
  }
});
Object.defineProperty(exports, "DEFAULT_RETRYABLE_STATUS_CODES", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.DEFAULT_RETRYABLE_STATUS_CODES;
  }
});
Object.defineProperty(exports, "DEFAULT_RETRY_POLICY", {
  enumerable: true,
  get: function () {
    return _RetryPolicy.DEFAULT_RETRY_POLICY;
  }
});
Object.defineProperty(exports, "FetchAdapter", {
  enumerable: true,
  get: function () {
    return _FetchAdapter.FetchAdapter;
  }
});
Object.defineProperty(exports, "NetworkManager", {
  enumerable: true,
  get: function () {
    return _NetworkManager.NetworkManager;
  }
});
Object.defineProperty(exports, "RetryEngine", {
  enumerable: true,
  get: function () {
    return _RetryEngine.RetryEngine;
  }
});
Object.defineProperty(exports, "RetryError", {
  enumerable: true,
  get: function () {
    return _RetryError.RetryError;
  }
});
Object.defineProperty(exports, "SAFE_RETRY_METHODS", {
  enumerable: true,
  get: function () {
    return _RetryPolicy.SAFE_RETRY_METHODS;
  }
});
exports.SmartRetry = void 0;
Object.defineProperty(exports, "SmartRetryClient", {
  enumerable: true,
  get: function () {
    return _SmartRetry.SmartRetryClient;
  }
});
Object.defineProperty(exports, "calculateDelay", {
  enumerable: true,
  get: function () {
    return _calculateDelay.calculateDelay;
  }
});
Object.defineProperty(exports, "classifyStatusError", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.classifyStatusError;
  }
});
Object.defineProperty(exports, "classifyThrownError", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.classifyThrownError;
  }
});
Object.defineProperty(exports, "createDefaultNetworkMonitor", {
  enumerable: true,
  get: function () {
    return _NetworkManager.createDefaultNetworkMonitor;
  }
});
Object.defineProperty(exports, "createSmartRetry", {
  enumerable: true,
  get: function () {
    return _SmartRetry.createSmartRetry;
  }
});
Object.defineProperty(exports, "isMethodRetryable", {
  enumerable: true,
  get: function () {
    return _RetryPolicy.isMethodRetryable;
  }
});
Object.defineProperty(exports, "isOnlineState", {
  enumerable: true,
  get: function () {
    return _NetworkState.isOnlineState;
  }
});
Object.defineProperty(exports, "isRetryable", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.isRetryable;
  }
});
Object.defineProperty(exports, "parseRetryAfter", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.parseRetryAfter;
  }
});
Object.defineProperty(exports, "serializeError", {
  enumerable: true,
  get: function () {
    return _ErrorClassifier.serializeError;
  }
});
var _SmartRetry = require("./core/SmartRetry");
var _AsyncStorageStorage = require("./storage/AsyncStorageStorage");
var _NetworkManager = require("./network/NetworkManager");
var _NetworkState = require("./network/NetworkState");
var _RetryEngine = require("./retry/RetryEngine");
var _calculateDelay = require("./retry/calculateDelay");
var _RetryPolicy = require("./retry/RetryPolicy");
var _ErrorClassifier = require("./errors/ErrorClassifier");
var _RetryError = require("./errors/RetryError");
var _AppLifecycleManager = require("./lifecycle/AppLifecycleManager");
var _FetchAdapter = require("./adapters/FetchAdapter");
/**
 * The default SmartRetry singleton. Call `SmartRetry.initialize()` once near
 * your app's root (e.g. in a top-level `useEffect`) before issuing requests.
 *
 * ```ts
 * import { SmartRetry } from 'react-native-smart-retry';
 *
 * await SmartRetry.initialize();
 *
 * const result = await SmartRetry.request({
 *   url: 'https://api.example.com/attendance',
 *   method: 'POST',
 *   data: { employeeId: 123 },
 *   queue: true,
 * });
 * ```
 */
const SmartRetry = exports.SmartRetry = new _SmartRetry.SmartRetryClient();
//# sourceMappingURL=index.js.map