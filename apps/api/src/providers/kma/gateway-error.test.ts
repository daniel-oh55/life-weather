import { describe, expect, it } from 'vitest';

import { detectKmaGatewayError } from './gateway-error';

/** A 공공데이터포털 gateway error envelope with a given reason code and auth message. */
function gatewayXml(reasonCode: string | null, authMsg: string): string {
  const reasonTag =
    reasonCode === null ? '' : `<returnReasonCode>${reasonCode}</returnReasonCode>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenAPI_ServiceResponse>',
    '<cmmMsgHeader>',
    '<errMsg>SERVICE ERROR</errMsg>',
    reasonTag,
    `<returnAuthMsg>${authMsg}</returnAuthMsg>`,
    '</cmmMsgHeader>',
    '</OpenAPI_ServiceResponse>',
  ].join('');
}

describe('detectKmaGatewayError — gateway wrappers', () => {
  it('detects the wrapper and extracts a numeric reason code', () => {
    const result = detectKmaGatewayError(gatewayXml('30', 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR'));
    expect(result).toEqual({ isGatewayError: true, reasonCode: '30' });
  });

  it('detects the wrapper with no reason code (reasonCode: null)', () => {
    const result = detectKmaGatewayError(gatewayXml(null, 'LIMITED_NUMBER_OF_SERVICE_REQUESTS'));
    expect(result).toEqual({ isGatewayError: true, reasonCode: null });
  });

  it('detects a bare cmmMsgHeader wrapper', () => {
    const xml = '<cmmMsgHeader><returnReasonCode>22</returnReasonCode></cmmMsgHeader>';
    expect(detectKmaGatewayError(xml)).toEqual({ isGatewayError: true, reasonCode: '22' });
  });

  it('trims surrounding whitespace around the reason code', () => {
    const xml = '<OpenAPI_ServiceResponse><returnReasonCode>  30  </returnReasonCode></OpenAPI_ServiceResponse>';
    expect(detectKmaGatewayError(xml).reasonCode).toBe('30');
  });

  it('yields reasonCode: null for a non-numeric reason code', () => {
    const xml = '<OpenAPI_ServiceResponse><returnReasonCode>BAD</returnReasonCode></OpenAPI_ServiceResponse>';
    expect(detectKmaGatewayError(xml)).toEqual({ isGatewayError: true, reasonCode: null });
  });

  it('never exposes the raw returnAuthMsg', () => {
    const secret = 'SECRET_LOOKING_AUTH_abcDEF123==';
    const result = detectKmaGatewayError(gatewayXml('30', secret));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('returnAuthMsg');
  });
});

describe('detectKmaGatewayError — non-gateway bodies', () => {
  it('does not treat arbitrary XML as a gateway error', () => {
    expect(detectKmaGatewayError('<foo><bar>baz</bar></foo>')).toEqual({
      isGatewayError: false,
      reasonCode: null,
    });
  });

  it('does not treat HTML as a gateway error', () => {
    const html = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>';
    expect(detectKmaGatewayError(html)).toEqual({ isGatewayError: false, reasonCode: null });
  });

  it('does not treat a JSON forecast body as a gateway error', () => {
    const json = '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"}}}';
    expect(detectKmaGatewayError(json)).toEqual({ isGatewayError: false, reasonCode: null });
  });
});
