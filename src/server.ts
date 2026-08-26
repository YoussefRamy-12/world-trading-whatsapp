import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./supabase";
import "./telegram";
import {
  createPlayer,
  getPlayer,
  collectPlayerIncome,
  buyCountry,
  sellCountry,
  createCountryOffer,
  acceptCountryOffer,
  cancelCountryOffer,
  upgradeCountry,
  getLeaderboard,
  getDailyLeaderboard,
  adminAdjustBalance,
  adminUpdateCountry,
} from "./game";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    message: "World Trading Game backend is running",
  });
});

app.get("/test-db", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("game_settings")
      .select("*")
      .limit(1);

    if (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }

    res.json({
      success: true,
      message: "Supabase connection is working",
      data,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: "Database connection failed",
    });
  }
});

app.post("/players", async (req, res) => {
  try {
    const { whatsappNumber, name } = req.body;

    if (!whatsappNumber || !name) {
      return res.status(400).json({
        success: false,
        error: "whatsappNumber and name are required",
      });
    }

    const result = await createPlayer(
      whatsappNumber,
      name
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: "Could not create player",
    });
  }
});

app.get("/players/:whatsappNumber", async (req, res) => {
  try {
    const player = await getPlayer(
      req.params.whatsappNumber
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "Player not found",
      });
    }

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: "Could not get player",
    });
  }
});

app.get("/players/:whatsappNumber/balance", async (req, res) => {
  try {
    const player = await getPlayer(
      req.params.whatsappNumber
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "Player not found",
      });
    }

    const incomeResult = await collectPlayerIncome(
      player.id
    );

    const updatedPlayer = await getPlayer(
      req.params.whatsappNumber
    );

    res.json({
      success: true,
      balance: updatedPlayer?.balance,
      incomeCollected: incomeResult.income,
      incomeDetails: incomeResult.countries,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: "Could not calculate balance",
    });
  }
});

app.post("/players/:whatsappNumber/buy", async (req, res) => {
  try {
    const player = await getPlayer(
      req.params.whatsappNumber
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "Player not found",
      });
    }

    const { countryId } = req.body;

    if (!countryId) {
      return res.status(400).json({
        success: false,
        error: "countryId is required",
      });
    }

    const result = await buyCountry(
      player.id,
      countryId
    );

    res.json(result);

  } catch (error: any) {
    console.error(error);

    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/players/:whatsappNumber/sell", async (req, res) => {
  try {
    const player = await getPlayer(
      req.params.whatsappNumber
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "Player not found",
      });
    }

    const { countryId } = req.body;

    if (!countryId) {
      return res.status(400).json({
        success: false,
        error: "countryId is required",
      });
    }

    const result = await sellCountry(
      player.id,
      countryId
    );

    res.json(result);

  } catch (error: any) {
    console.error(error);

    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/players/:whatsappNumber/offers", async (req, res) => {
  try {
    const player = await getPlayer(
      req.params.whatsappNumber
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "Player not found",
      });
    }

    const { countryId, price } = req.body;

    if (!countryId || price === undefined) {
      return res.status(400).json({
        success: false,
        error: "countryId and price are required",
      });
    }

   const result = await createCountryOffer(
  player.id,
  countryId,
  Number(price)
);

    res.json(result);

  } catch (error: any) {
    console.error(error);

    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

app.post(
  "/players/:whatsappNumber/offers/:offerId/accept",
  async (req, res) => {
    try {
      const player = await getPlayer(
        req.params.whatsappNumber
      );

      if (!player) {
        return res.status(404).json({
          success: false,
          error: "Player not found",
        });
      }

      const result = await acceptCountryOffer(
        player.id,
        req.params.offerId
      );

      res.json(result);

    } catch (error: any) {
      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }
);
app.post(
  "/players/:whatsappNumber/offers/:offerId/cancel",
  async (req, res) => {
    try {
      const player = await getPlayer(
        req.params.whatsappNumber
      );

      if (!player) {
        return res.status(404).json({
          success: false,
          error: "Player not found",
        });
      }

      const result = await cancelCountryOffer(
        player.id,
        req.params.offerId
      );

      res.json(result);

    } catch (error: any) {
      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }
);

app.post(
  "/players/:whatsappNumber/countries/:countryId/upgrade",
  async (req, res) => {
    try {
      const player = await getPlayer(
        req.params.whatsappNumber
      );

      if (!player) {
        return res.status(404).json({
          success: false,
          error: "Player not found",
        });
      }

      const result = await upgradeCountry(
        player.id,
        req.params.countryId
      );

      res.json(result);

    } catch (error: any) {
      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }
);

app.get(
  "/leaderboard",
  async (_req, res) => {
    try {
      const result = await getLeaderboard();

      res.json({
        success: true,
        leaderboard: result,
      });

    } catch (error: any) {
      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }
);

app.get(
  "/leaderboard/daily",
  async (req, res) => {
    try {
      const date =
        typeof req.query.date === "string"
          ? req.query.date
          : undefined;

      const result =
        await getDailyLeaderboard(date);

      res.json({
        success: true,
        leaderboard: result,
      });

    } catch (error: any) {
      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }
);

app.post(
  "/admin/:adminWhatsappNumber/players/:targetWhatsappNumber/balance",
  async (req, res) => {
    try {

      const admin =
        await getPlayer(
          req.params.adminWhatsappNumber
        );

      if (!admin) {
        return res.status(404).json({
          success: false,
          error: "Admin not found",
        });
      }

      const target =
        await getPlayer(
          req.params.targetWhatsappNumber
        );

      if (!target) {
        return res.status(404).json({
          success: false,
          error: "Target player not found",
        });
      }

      const amount =
        Number(req.body.amount);

      const reason =
        req.body.reason;

      const result =
        await adminAdjustBalance(
          admin.id,
          target.id,
          amount,
          reason
        );

      res.json(result);

    } catch (error: any) {

      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });

    }
  }
);

app.post(
  "/admin/:adminWhatsappNumber/countries/:countryId",
  async (req, res) => {
    try {

      const admin =
        await getPlayer(
          req.params.adminWhatsappNumber
        );

      if (!admin) {
        return res.status(404).json({
          success: false,
          error: "Admin not found",
        });
      }

      const result =
        await adminUpdateCountry(
          admin.id,
          req.params.countryId,
          Number(req.body.currentPrice),
          Number(req.body.hourlyIncome),
          req.body.reason
        );

      res.json(result);

    } catch (error: any) {

      console.error(error);

      res.status(400).json({
        success: false,
        error: error.message,
      });

    }
  }
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});