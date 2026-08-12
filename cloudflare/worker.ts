export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("LiveFlow webhook is ready", { status: 200 });
    }

    const event = await request.json().catch(() => ({}));
    console.log("LiveFlow event", event);

    // ใส่คำสั่งของระบบภายนอกตรงนี้ เช่น เรียก API เกม, Discord หรือ Smart Device
    return Response.json({ ok: true, received: event });
  },
};

