import js from '@eslint/js';
import globals from 'globals';

// The README promises that a recording never leaves the computer. The Content Security Policy
// blocks most ways out but not navigation or WebRTC, so the app's code must not use any of them.
const WAYS_OUT = [
  'EventSource',
  'RTCPeerConnection',
  'WebSocket',
  'WebTransport',
  'XMLHttpRequest',
  'fetch',
  'location',
  'sendBeacon',
  'webkitRTCPeerConnection',
];
const message =
  'Ventris never sends a recording anywhere. See "Keeping recordings private" in CONTRIBUTING.md.';

export default [
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Identifier[name=/^(${WAYS_OUT.join('|')})$/]`, message },
        { selector: "CallExpression[callee.name='open']", message },
        { selector: "MemberExpression[object.name='window'][property.name='open']", message },
      ],
    },
  },
  {
    files: ['test/**/*.js', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
];
