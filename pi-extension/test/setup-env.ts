// Tests must not inherit child classification from the Pi process that invoked
// the suite. Individual policy/extension tests set these values explicitly.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_DESCRIPTOR;
