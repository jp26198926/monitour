import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';
import { randomBytes } from 'node:crypto';

const enrollmentTokenSchema = new Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => randomBytes(32).toString('hex'),
    },
    label: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedByDevice: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
  },
  { timestamps: true },
);

enrollmentTokenSchema.methods.isValid = function (): boolean {
  return this.usedAt === null && this.expiresAt > new Date();
};

export interface IEnrollmentTokenMethods {
  isValid(): boolean;
}

export interface IEnrollmentTokenModel
  extends Model<InferSchemaType<typeof enrollmentTokenSchema>, {}, IEnrollmentTokenMethods> {}

export type EnrollmentTokenDoc = InferSchemaType<typeof enrollmentTokenSchema> & {
  _id: mongoose.Types.ObjectId;
} & IEnrollmentTokenMethods;

export const EnrollmentToken = mongoose.model<
  InferSchemaType<typeof enrollmentTokenSchema>,
  IEnrollmentTokenModel
>('EnrollmentToken', enrollmentTokenSchema);
