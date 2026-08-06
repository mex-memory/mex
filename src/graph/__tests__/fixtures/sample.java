package com.example.demo;

import java.util.List;
import com.example.models.Widget;
import static java.util.Collections.emptyList;
import com.example.util.*;

/**
 * Demo greeter.
 */
@Deprecated
public class Greeter extends Base implements Speaker {
  public static final int MAX = 10;
  private String name;

  public Greeter(String name) {
    this.name = name;
  }

  public String greet(Widget w) {
    w.touch();
    emptyList();
    return format(name);
  }

  private String format(String s) {
    Runnable r = () -> System.out.println(s);
    return s;
  }

  public static class Nested {
    public void run() {}
  }
}

public record Point(int x, int y) {}

public enum Role {
  ADMIN,
  USER
}

public @interface Flag {
  String value() default "";
}

public interface Speaker {
  String speak();
}

abstract class Base {
  abstract void hook();
}
