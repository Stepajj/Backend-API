export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;

  name?: string | null;
  surname?: string | null;
  birthDate?: Date | null;
  role?: "BUYER" | "SELLER" | "ADMIN";
  status?: "ACTIVE" | "SUSPENDED";
  
}
