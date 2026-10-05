import type { Config } from '../config.js';
import { FakeProvider } from './fake.js';
import { MonnifyProvider } from './monnify.js';
import type { PaymentProvider } from './provider.js';

export function createProvider(c: Config): PaymentProvider {
  if (c.PAYMENT_PROVIDER === 'monnify') {
    return new MonnifyProvider({
      baseUrl: c.MONNIFY_BASE_URL, apiKey: c.MONNIFY_API_KEY, secretKey: c.MONNIFY_SECRET_KEY,
      contractCode: c.MONNIFY_CONTRACT_CODE, walletAccountNumber: c.MONNIFY_WALLET_ACCOUNT,
      requireSignature: c.MONNIFY_REQUIRE_SIGNATURE,
    });
  }
  return new FakeProvider();
}
