import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';
import { randomBytes } from 'node:crypto';

const enrollmentKeySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 64 },
    /** Long-lived bearer secret (reusable; maxUses:1 covers one-time use). */
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => randomBytes(32).toString('hex'),
    },
    /** Device.group name assigned on enroll. */
    group: { type: String, default: null },
    /** Device.labels assigned on enroll. */
    labels: { type: [String], default: [] },
    /** null = unlimited uses. */
    maxUses: { type: Number, default: null },
    useCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

enrollmentKeySchema.methods.isValid = function (): boolean {
  if (this.revokedAt !== null) return false;
  if (this.expiresAt !== null && this.expiresAt <= new Date()) return false;
  if (this.maxUses !== null && this.useCount >= this.maxUses) return false;
  return true;
};

export interface IEnrollmentKeyMethods {
  isValid(): boolean;
}

export interface IEnrollmentKeyModel
  extends Model<InferSchemaType<typeof enrollmentKeySchema>, {}, IEnrollmentKeyMethods> {}

export type EnrollmentKeyDoc = InferSchemaType<typeof enrollmentKeySchema> & {
  _id: mongoose.Types.ObjectId;
} & IEnrollmentKeyMethods;

export const EnrollmentKey = mongoose.model<
  InferSchemaType<typeof enrollmentKeySchema>,
  IEnrollmentKeyModel
>('EnrollmentKey', enrollmentKeySchema);
