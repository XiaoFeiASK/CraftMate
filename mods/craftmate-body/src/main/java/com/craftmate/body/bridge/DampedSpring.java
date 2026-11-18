package com.craftmate.body.bridge;

/**
 * Frame-rate independent, critically damped one-dimensional spring.
 *
 * <p>The exact solution is used instead of an Euler step, so a 30 Hz frame and
 * two 60 Hz frames settle to the same place. A speed ceiling keeps a long
 * render stall from consuming a backlog in one frame.
 */
public final class DampedSpring {
	private double position;
	private double velocity;
	private boolean initialized;

	public boolean initialized() {
		return initialized;
	}

	public double position() {
		return position;
	}

	public double velocity() {
		return velocity;
	}

	public void reset() {
		position = 0.0;
		velocity = 0.0;
		initialized = false;
	}

	public void snap(double target) {
		snap(target, 0.0);
	}

	public void snap(double target, double velocity) {
		position = target;
		this.velocity = velocity;
		initialized = true;
	}

	public void step(double target, double dt, double omega, double maxSpeed) {
		if (!initialized) {
			snap(target);
			return;
		}
		if (dt <= 0.0 || omega <= 0.0) return;
		double x = position - target;
		double decay = Math.exp(-omega * dt);
		double impulse = (velocity + omega * x) * dt;
		double nextX = (x + impulse) * decay;
		double nextVelocity = (velocity - omega * impulse) * decay;
		position = target + nextX;
		velocity = clampSpeed(nextVelocity, maxSpeed);
	}

	public void stepAngle(double target, double dt, double omega, double maxSpeed) {
		if (!initialized) {
			snapAngle(target);
			return;
		}
		if (dt <= 0.0 || omega <= 0.0) return;
		double error = wrapDegrees(position - target);
		double decay = Math.exp(-omega * dt);
		double impulse = (velocity + omega * error) * dt;
		double nextError = (error + impulse) * decay;
		double nextVelocity = (velocity - omega * impulse) * decay;
		position = wrapDegrees(target + nextError);
		velocity = clampSpeed(nextVelocity, maxSpeed);
	}

	public void snapAngle(double target) {
		position = wrapDegrees(target);
		velocity = 0.0;
		initialized = true;
	}

	private static double clampSpeed(double velocity, double maxSpeed) {
		if (maxSpeed <= 0.0 || Double.isInfinite(maxSpeed)) return velocity;
		return Math.max(-maxSpeed, Math.min(maxSpeed, velocity));
	}

	public static double wrapDegrees(double degrees) {
		double wrapped = degrees % 360.0;
		if (wrapped >= 180.0) wrapped -= 360.0;
		if (wrapped < -180.0) wrapped += 360.0;
		return wrapped;
	}
}
