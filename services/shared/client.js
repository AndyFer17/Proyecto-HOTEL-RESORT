import { AppError } from './errors.js';

async function readJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new Error('Respuesta demasiado grande.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : null;
  } finally {
    reader.releaseLock();
  }
}

export async function callService(
  base,
  path,
  {
    method = 'GET',
    body,
    key,
    traceId,
    token,
    timeoutMs = 3000,
    headers = {},
  } = {},
) {
  const attempts = method === 'GET' || key ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(new URL(path, base), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...headers,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(traceId ? { 'X-Request-Id': traceId } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await readJson(response);
      if (!response.ok) {
        const safeStatus = [400, 404, 409, 422].includes(response.status)
          ? response.status
          : 503;
        throw new AppError(
          safeStatus,
          data?.codigo ?? 'DEPENDENCIA_NO_DISPONIBLE',
          safeStatus === 503
            ? 'No se pudo completar la comunicación entre servicios.'
            : (data?.mensaje ?? 'La dependencia rechazó la operación.'),
        );
      }
      return { status: response.status, body: data };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (attempt === attempts - 1)
        throw new AppError(
          503,
          'DEPENDENCIA_NO_DISPONIBLE',
          'No se pudo completar la comunicación entre servicios.',
        );
    }
  }
}
