import { createHash, randomUUID } from 'node:crypto';
import { importPKCS8, importSPKI, exportJWK, SignJWT, jwtVerify } from 'jose';

export async function createTokens(config) {
  const privateKey = await importPKCS8(
    Buffer.from(config.JWT_PRIVATE_KEY_BASE64, 'base64').toString(),
    'RS256',
  );
  const publicKey = await importSPKI(
    Buffer.from(config.JWT_PUBLIC_KEY_BASE64, 'base64').toString(),
    'RS256',
  );
  const publicJwk = await exportJWK(publicKey);
  const kid = createHash('sha256')
    .update(publicJwk.n)
    .digest('hex')
    .slice(0, 16);
  const jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };
  // Detectar claves que no forman pareja antes de iniciar el servidor.
  const probe = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .sign(privateKey);
  await jwtVerify(probe, publicKey, { algorithms: ['RS256'] });
  return {
    jwks,
    async issue(client) {
      return new SignJWT({ rol: client.rol })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
        .setSubject(client.clienteId)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.JWT_TTL_SECONDS}s`)
        .setJti(randomUUID())
        .sign(privateKey);
    },
    async verify(token) {
      const { payload } = await jwtVerify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        requiredClaims: ['sub', 'iat', 'exp', 'jti', 'rol'],
      });
      if (payload.rol !== 'HUESPED' || typeof payload.sub !== 'string')
        throw new Error('Identidad inválida');
      return payload;
    },
  };
}
