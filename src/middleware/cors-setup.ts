import cors from 'cors';

export function createCorsMiddleware(): ReturnType<typeof cors> {
  return cors({
    origin: true, // Allow all origins
    credentials: true // Allow credentials
  });
}