import mongoose from 'mongoose';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db');

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  mongoose.connection.on('connected', () => log.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => log.error('MongoDB error', err));
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
  });

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export { User } from './models/User.js';
export { Device } from './models/Device.js';
export { EnrollmentToken } from './models/EnrollmentToken.js';
export { Group } from './models/Group.js';
export { ServerSettings } from './models/ServerSettings.js';
