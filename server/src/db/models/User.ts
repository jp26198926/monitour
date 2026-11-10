import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_.-]{3,32}$/,
    },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, trim: true, default: '' },
    role: {
      type: String,
      enum: ['admin', 'operator', 'viewer'],
      default: 'operator',
    },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.statics.hashPassword = function (plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
};

export interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>;
}

export interface IUserModel extends Model<InferSchemaType<typeof userSchema>, {}, IUserMethods> {
  hashPassword(plain: string): Promise<string>;
}

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId } & IUserMethods;

export const User = mongoose.model<InferSchemaType<typeof userSchema>, IUserModel>('User', userSchema);
