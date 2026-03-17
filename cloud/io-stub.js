/** Stub for trackerserver: no-op io so we don't load workingwelleth (which binds to 3000/443) */
module.exports = {
  io: {
    emit: () => {},
    on: () => {},
  },
};
