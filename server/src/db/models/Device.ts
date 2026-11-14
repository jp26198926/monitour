import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const systemInfoSchema = new Schema(
  {
    hostname: String,
    platform: String,
    arch: String,
    cpus: Number,
    totalMemMB: Number,
    freeMemMB: Number,
    uptimeSec: Number,
    loadAvg: [Number],
    osVersion: String,
  },
  { _id: false },
);

const deviceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    hostname: { type: String, default: '' },
    platform: { type: String, default: 'unknown' },
    arch: { type: String, default: 'unknown' },
    status: {
      type: String,
      enum: ['online', 'offline', 'pending', 'error'],
      default: 'pending',
    },
    agentVersion: { type: String, default: '0.0.0' },

    // --- Authentication ---
    /** Agent-generated RSA public key (PEM). Used to verify signed challenges. */
    publicKeyPem: { type: String, required: true },
    /** SHA-256 fingerprint of publicKeyPem — the agent's identity on the server. */
    publicKeyFingerprint: { type: String, required: true, unique: true, index: true },
    /** Last time the agent connected via Socket.IO. */
    lastSeen: { type: Date, default: null },

    // --- Organization ---
    labels: { type: [String], default: [] },
    notes: { type: String, default: '' },
    /** Group name (not ObjectId — simpler for display/filtering). */
    group: { type: String, default: null, index: true },
    /** User-defined alias name. */
    alias: { type: String, default: '', maxlength: 64 },
    /** Reusable enrollment key that registered this device (audit trail). */
    enrollmentKeyId: { type: Schema.Types.ObjectId, ref: 'EnrollmentKey', default: null },

    // --- Live stats ---
    systemInfo: { type: systemInfoSchema, default: null },

    enrolledAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

deviceSchema.index({ status: 1 });
deviceSchema.index({ labels: 1 });

export interface IDeviceModel extends Model<InferSchemaType<typeof deviceSchema>> {}
export type DeviceDoc = InferSchemaType<typeof deviceSchema> & { _id: mongoose.Types.ObjectId };

export const Device = mongoose.model<InferSchemaType<typeof deviceSchema>, IDeviceModel>('Device', deviceSchema);
