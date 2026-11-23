import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../security/passwords.js';
import { AppError } from '../errors.js';

function profile(client) {
  return {
    clienteId: client.clienteId,
    nombre: client.nombre,
    email: client.email,
    telefono: client.telefono,
    rol: client.rol,
    creadoEn: client.creadoEn,
  };
}

export async function createClientesService(repository, tokens, ttl) {
  // Igualar el trabajo criptográfico cuando el correo no existe.
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  return {
    async register(input) {
      const passwordHash = await hashPassword(input.password);
      return profile(await repository.create({ ...input, passwordHash }));
    },
    async login(input) {
      const client = await repository.findByEmail(input.email);
      const valid = await verifyPassword(
        input.password,
        client?.passwordHash ?? dummyHash,
      );
      if (!client || !valid)
        throw new AppError(
          401,
          'CREDENCIALES_INVALIDAS',
          'Correo o contraseña incorrectos.',
        );
      return {
        accessToken: await tokens.issue(client),
        tokenType: 'Bearer',
        expiresIn: ttl,
      };
    },
    async getProfile(id, identity) {
      if (id !== identity.sub)
        throw new AppError(
          403,
          'ACCESO_DENEGADO',
          'Solo puedes consultar tu propio perfil.',
        );
      const client = await repository.findById(id);
      if (!client)
        throw new AppError(
          404,
          'CLIENTE_NO_ENCONTRADO',
          'No se encontró el huésped.',
        );
      return profile(client);
    },
  };
}
