import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { unauthorized } from "../lib/errors.js";

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  // Self-service password change. Requires the current password so a stolen,
  // still-valid access token cannot silently lock the owner out.
  app.post("/password", async (req) => {
    const { currentPassword, newPassword } = ChangePasswordBody.parse(req.body);
    const userId = (req.user as { sub: string }).sub;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthorized();
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw unauthorized("Current password is incorrect");
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { success: true, data: { changed: true } };
  });

  app.post("/walkthrough-complete", async (req) => {
    const userId = (req.user as { sub: string }).sub;
    await prisma.user.update({
      where: { id: userId },
      data: { walkthroughCompleted: true },
    });
    return { success: true, data: { walkthroughCompleted: true } };
  });

  app.get("/", async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, walkthroughCompleted: true },
    });
    return { success: true, data: user };
  });
};

export default routes;
